# Phase D: agent integration evidence

Verification date: 2026-10-11. D1 and D2 are implemented and independently reviewed locally through `94af6078c6ad3d48cb431e5360097fdb494cd21a`. The final controller checkpoint below supersedes the historical task-run counts. Physical-phone/reachable public HTTPS behavior, Phase E and release acceptance remain pending. These local tests do not establish a public deployment or an installable release.

## D1 executed checks

All checks used independently generated credentials and synthetic bytes in this repository's dedicated fixtures. Applied SQL migrations 001–004 remain unchanged. No private application, runtime configuration, data, database, source history or deployment was accessed. The host ran Node 24.21.0 and Python 3.14 on Windows; application/database containers were pinned Linux amd64 Node 24.21.0 and PostgreSQL 17.11.

| Command/check | Observed result |
| --- | --- |
| `npm run validate:openapi` | OpenAPI 3.1 validates with 21 distinct operation IDs; external reference resolution disabled. |
| `npm test -- tests/server/instanceRoutes.test.ts` | 5 passed. Metadata/static skill first failed with two expected 404 responses before implementation. |
| `npm test` | 364 passed, 2 existing Windows POSIX skips; 366 tests in 26 files. |
| `npm run test:integration -- tests/integration/apiContract.test.ts tests/integration/agentRoundtrip.test.ts` through the isolated fixture launcher | 10 passed after review fixes, against a dedicated disposable PostgreSQL 17.11 server and independently owned per-test databases/storage roots. |
| `npm run typecheck`; `npm run build` | Server/client typechecks and client/server build passed. |
| `python -m unittest discover -s tests/examples -p 'test_roundtrip.py'` | 19 passed on native Windows Python 3.14, including an oversized chunked HTTP response. |
| `python -m py_compile examples/roundtrip.py` | Passed on Windows Python 3.14. |
| Owned Linux client container: `AGENTFILES_SHELL_TESTS=1 python3 -m unittest discover -s tests/examples -p 'test_*.py'` | 30 passed after review fixes: 19 Python and 11 Bash/curl/jq mock-server cases; no network except in-container loopback servers. |
| Owned Linux client container: `bash -n examples/upload.sh`; `python3 -m py_compile examples/roundtrip.py` | Both passed. Windows Bash was not assumed or exercised. |
| `node scripts/smoke-compose.mjs --agents` | 14 actual scenarios passed during D1. The controller later repeated all 14 with the reviewed final Phase D tree; see the checkpoint below. Only uniquely owned smoke resources were removed. |
| `node scripts/generate-notices.mjs`; `node scripts/generate-notices.mjs --check` | Regeneration/check passed for 279 installed locations and 289 notice sections. |

The focused integration suite observes every real Fastify `onRoute` registration before handlers register, excluding only automatic HEAD and the documented browser shell/assets. It runs actual handlers and PostgreSQL. Every JSON success operation is schema-validated: health/readiness/instance, session/login/logout, keys list/create/update/revoke, storage status, upload/list/metadata/retention/delete, share create/revoke. Real 400/401/403/410 errors are validated too. File DTO tests remove every required field and change a byte count to a string to prove rejection; equality checks preserve all aliases. Private attachment tests assert bytes, attachment/cache headers and absence of redirects. Exact expiry is tested using an injected fixture clock; no public time-control endpoint exists.

Review fixes require the intended response status before choosing a schema; a regression proves that a documented error cannot satisfy a success check. Actual anonymous same-origin logout returns 200 and clears the cookie; missing Origin and explicit Bearer requests remain denied. Request boundary tests cover exact and excessive UTF-8 byte lengths for ASCII/multibyte login fields and key names, whitespace-only/NUL names and raw length before trimming. OpenAPI documents byte limits through `x-max-utf8-bytes`, enforced by the tests' validator, alongside necessary character bounds.

Public metadata contains only six allowlisted fields. Static Markdown equals the checked-in distribution byte-for-byte regardless of cookie/key and is delivered as UTF-8 text. Arbitrary/traversal skill paths fail. The Dockerfile copies that reviewed asset explicitly; no credential/configuration interpolation occurs.

## Independent clients and real installation

The native Python subprocess uses a real listening HTTP server, a fresh scoped key and its own temporary directory. It uploads synthetic text, looks up metadata, checks private and anonymous share SHA-256 streams, revokes the share and deletes the remote file. A separate revoked-key run stops before upload. Upload-only cannot inspect; download-only cannot upload, change retention or delete. Explicit `--persist` with key permission but disabled installation policy returns 403 and allocates no file/code; the client never retries as temporary. Subprocess environments allow only OS/tool-discovery variables plus explicitly supplied synthetic fixture settings; outputs are bounded and error diagnostics sanitized.

The Compose runner expands the earlier ten installation checks with four agent scenarios. Each client receives a fresh named scoped key from actual administrator endpoints, through a private environment file rather than process arguments. Python uploads a text fixture and Bash/curl uploads an independently authored portrait SVG. Both return code/private URL/expiry, look up metadata, independently verify private and anonymous-share download checksums, explicitly revoke the share/delete the file, and observe unavailable share and revoked-key denial afterward.

The client container shares only the namespace of the label-verified owned application container, using its configured loopback origin; it receives no database or storage mount. The fixture's published host port remains unique and loopback-bound. The Linux tools are Bash 5.2, curl 7.88.1, jq 1.6 and Python 3.11; their direct Debian package versions and image digest are pinned in the runner. The client image is disposable.

Real end-to-end expiry uses one disposable file row changed to past expiry by `psql` only inside the runner's verified fixture database. New authenticated metadata returns 410 before cleanup. Normal user retention remains seven days; there is no runtime expiry-shortening API. This is distinct from the deterministic injected-clock case and does not claim that the smoke waited seven days.

The other actual Compose scenarios repeat fresh build/migration/start gates, loopback/no-database-port topology, login/cookie/upload/download, database-outage readiness, app recreation, SIGINT/SIGTERM drain, wrong-owner/world-writable storage refusal, corrupt migration blocking startup and the independently owned external-database alternative.

## Safety checks and limits

Python streams multipart upload with explicit Content-Length, incremental hashes and bounded input/JSON/download sizes. It rejects configured-origin ambiguity and every redirect before forwarding any credential. Bash disables tracing and ambient curl configuration, escapes its private mode-0600 curl configuration, rejects newline keys, bounds JSON bodies including chunked responses with a streaming pipe, validates exact origin/code paths, and creates new output in a private directory. Both omit cookies, reject unsafe filenames/paths and preserve existing local files. Explicit share verification sends no credential. Neither retries uploads or claims idempotency.

Mock negatives are separate from real runtime evidence. They cover hostile/local-traversal filenames, cross-origin JSON download URLs, redirects to a second server that receives zero requests/credentials, existing output, SHA mismatch and uncertain upload outcomes. Python reproduces a real socket timeout after the mock receives POST. Shell reproduces response loss after POST and performs no second POST. New shell behavior first had three expected failures for JSON bounds, canonical codes and explicit sharing, then passed. Linux mock checks run with `--network none`; loopback serves only synthetic HTTP fixtures.

The added review tests emit actual HTTP/1.1 chunk framing with `Transfer-Encoding: chunked` and no Content-Length. Both clients reject a 2 MiB session response at their 1 MiB JSON bound and make no upload request. This executed chunked evidence supplements the earlier Content-Length cases; it is mock evidence, not a claim that the application emitted chunked JSON in Compose.

Complete staged-diff inspection and redacted secret/private-identifier checks passed before the local commits, including the distributed skill. Compose verified public instance fields, literal served skill bytes and absence of fixture secrets; its runtime artifact check excluded environment/private/test/source directories and matched immutable migration bytes. D1 independently passed task review after fixes. D1 does not claim native Linux host installation, Windows Bash, other architectures, public HTTPS, phone/browser acceptance, full-size 1 GiB transfer performance, abrupt-power-loss durability, upgrades/restores, public-clone CI or release publication. The dedicated Phase D PostgreSQL fixture was retained for controller checks and removed at the final checkpoint below.

## D2: focused onboarding and browser handoff

Date: 2026-10-11. D2 implementation and independent task/whole-branch review are complete after the fixes recorded below. AgentFiles remains in preparation; release acceptance is not completed. No server lifecycle logic, migration, production deployment or private application input changed in D2.

The UI now consumes public instance policy, offers named minimal upload/download keys with optional listing and explicit destructive/share/persistence permissions, and checks only the supplied Bearer key with `credentials: omit` and `redirect: error`. Connection success requires an authenticated API-key principal and displays actual permission flags. One-time secrets and check input stay in React memory, clear on dismiss/revoke/logout/settings unmount, and cannot be restored by late responses. Static skill downloads remain literal generic instructions. Lookup uses the canonical five-symbol alphabet and actual metadata routes independent of the 200-item list; the library filter explicitly covers listed items. Deep links preserve status errors. Selected/downloaded metadata is rechecked for expiry, gallery order is retained for listed selections, native dialog closes on file change, and deferred metadata/actions preserve the newer selection.

Upload queues retain the full File DTO and show private link, code, expiry/persistence and checksum with separate copy actions. No upload/private-copy path creates a public share. Persistence is disabled by installation policy. Lost or malformed upload responses report an unknown outcome without retrying. Settings shows authenticated C3 managed/reserved/capacity/pending-expiry counters, cleanup last success and delayed/unavailable states.

| Executed command | Observed result |
| --- | --- |
| `npm test -- tests/client` | 25 rendered DOM/API tests passed in four files at the initial D2 commit, before review fixes. |
| `npm test` | 389 passed, two existing Windows POSIX skips; 391 tests in 30 files at the initial D2 commit, before review fixes. |
| `npm run typecheck`; `npm run build` | Client/server typechecks and client/server build passed. |
| `npm run test:browser -- tests/browser/handoff.spec.ts` through a private environment launcher | 15 passed before the final upload-selection fix; the affected upload case then passed at all three widths. The final controller checkpoint exercises all 18 expanded checks after every review fix. |
| `npm run test:browser -- tests/browser/handoff.spec.ts --grep "upload result gives"` through a private environment launcher | Three affected upload scenarios passed after the final upload-selection fix, one per viewport. The full 15-case run above preceded that final client-only fix. |
| `node scripts/generate-notices.mjs`; `node scripts/generate-notices.mjs --check` | Passed for 282 installed locations and 303 notice sections. |
| `npm audit --json`; `npm audit --omit=dev --json` | Both exited zero with zero advisories. |

Tests ran on Windows x64, Node 24.21.0/npm 11.19.0, Playwright 1.64.0 and Chromium/headless shell 156.0.8078.4 revision 1248. PostgreSQL 17.11 is the already independently provisioned disposable Phase D server; each viewport owns a new sibling database and temporary disk root. The runner reserves a loopback port, supplies that origin before `buildServer` creates immutable instance metadata, and uses an explicit independent Playwright `webServer` with reuse disabled. Production rate limits remain unchanged. On Windows, where forced webServer termination may bypass signal cleanup, the launcher verifies registered ownership/bounds before dropping only its sibling database and temporary storage. The controller-owned base server/database remains retained.

Four independently generated fixtures are a 120×240 portrait PNG, 240×120 landscape PNG, one-second 240×120 WebM and one-second WAV tone. The fixture uploads them through actual scoped-key HTTP requests and verifies downloaded bytes against independently calculated SHA-256. To test beyond-page lookup without weakening the 120/minute throttle, it transactionally seeds 205 newer synthetic text rows with unique canonical issued codes and matching `files/UUID.txt` bytes; no code is reassigned. Browser checks prove the older HTTP-uploaded portrait is absent from the first listed page before exact lookup.

The browser suite checks rendered gallery/list detail, original image ratios and `object-fit: contain`, native modal/Escape/focus, video/audio metadata, exact download events/checksums, inline narrow detail, no horizontal overflow, keyboard Enter/Tab, bad key under a current administrator cookie, actual permission flags, no secret in static skill/storage/history, private upload results, server 410 expiry on recheck and actual revoked-share 410. Direct SQL expires/restores only the owned fixture row; there is no production time-control endpoint. Deferred browser route interception checks selection races. A separate response-abort case is a synthetic browser-network negative: it proves unknown-outcome messaging and a single POST, not a claim about a real interrupted server commit.

TDD first observed missing UI/connection/lookup/storage/persistence failures, then passing behavior. Added regressions first reproduced an old key-check success after changed input, failed preview state surviving a file change, malformed upload success being accepted, changed gallery order on listed selection, unavailable storage appearing pending forever, and a successful upload being omitted from selected detail when an earlier refresh was discarded. Their fixes passed. Tests additionally cover secret copy/dismiss/revoke/logout/unmount and late creation, 401/403/404/410 deep-link errors, exact lookup absent from the list, and raw one-time-key/header/database/share-path redaction before subprocess diagnostics print. Secret-free portrait screenshots were visually inspected; all fixture media/screenshots/raw diagnostics/credentials remain ignored.

Complete staged-diff inspection and redacted secret/private-identifier checks accompany every local implementation/fix commit. Independent reviews approved the final implementation after the fixes below. D2 does not establish a physical phone, reachable public HTTPS, native Linux browser, Firefox/WebKit/Safari, other architectures, range/resumable media, full-size 1 GiB transfer performance, installation/release acceptance or publication. No suitable authorized public infrastructure or physical device was available; narrow Chromium viewports are reported only as viewport evidence. The phone guide explains why a phone cannot use another machine's localhost and requires the configured reachable HTTPS origin.

## Final reviewed local checkpoint

Branch: `codex/phase-d`, based on `190fa0d07fca176cf0a6ef8640462630d13e213e`. Reviewed implementation head: `94af6078c6ad3d48cb431e5360097fdb494cd21a`. The subsequent documentation-only checkpoint records these results without changing application/test/dependency source.

| Public local commit | Result |
| --- | --- |
| `ce868d98a59c7382165a0f6d60e1bd1ab8c158d8` | D1 implementation: public metadata/static skill, observed OpenAPI and independent streaming clients. |
| `4fbfe1591021c7ddceaab16df48c7d047dab920b` | D1 review fixes: anonymous logout contract, UTF-8 request limits, explicit expected status and actual chunked-response negatives. |
| `1bcda50f9edaf39db620b01484fb8dbd89be9d71` | D2 implementation: focused onboarding, exact lookup, full private upload results and synthetic browser fixtures. |
| `269ef055ddf4108ad13571bf8457edd974c72f1a` | D2 review fixes: initial exact lookup independent of listing, independent key-management/check lifetimes. |
| `94af6078c6ad3d48cb431e5360097fdb494cd21a` | Whole-branch review fixes: authorized return from persistence to expiry under disabled new-persistence policy, failed deep-link error preserved alongside later library results. |

D1 and D2 independently passed task compliance/code-quality review after fixes. The final whole-branch review and its fix re-review approved the implementation with no remaining Critical, Important or Minor findings. Review is source inspection; the following controller execution evidence is separate.

| Controller command/check | Observed result and exact scope |
| --- | --- |
| `npm test` at the reviewed head | 407 passed, two existing Windows POSIX skips; 409 tests in 31 files, including 43 rendered client tests in five files. |
| `npm run typecheck`; `npm run build` at the reviewed head | Client/server typechecks and production builds passed. |
| `npm run validate:openapi` at the reviewed head | OpenAPI 3.1 valid, 21 unique operations, external resolution disabled. |
| `npm run test:integration` through the isolated launcher | Full real PostgreSQL suite: 124 passed, one existing Windows skip, ten files during D2 work at `4fbfe15`, with client changes in progress. Executed server, integration-test/helper, example and configuration source is byte-identical at `1bcda50` and the reviewed head; subsequent fixes changed client/rendered/browser tests only. This is unchanged-source evidence, not a claimed rerun at the final commit. |
| Pinned `test:browser` runner with `tests/browser/handoff.spec.ts` through the isolated launcher, at the reviewed head | 18 passed with retries disabled: six checks each at 1280×900, 390×844 and 320×740. Real HTTP/PostgreSQL, owned synthetic media, actual checksum downloads and native dialog behavior; added initial-list failures are intercepted test responses combined with real metadata200/410. |
| `node scripts/smoke-compose.mjs --agents` at the reviewed head | Fresh Linux amd64 runtime build and all 14 scenarios passed, including actual Python/Bash scoped-key roundtrips, SHA checks, explicit shares/revocation/deletion and fixture-only expiry. Linux client negative suite also passed all 30 cases. Only owned smoke services/networks/volumes/client image were removed. |
| `node scripts/generate-notices.mjs --check` at the reviewed head | Passed: 282 installed locations, 303 complete notice sections. |
| `npm audit --json`; `npm audit --omit=dev --json` at the reviewed head | Both exited zero with zero vulnerabilities. |
| Immutable migration and reviewed-source comparison | Migrations 001–004 unchanged from Phase C; server/lifecycle/integration source unchanged since the full PostgreSQL run. |
| Complete staged diff, Markdown links, redacted private-identifier and Gitleaks 8.30.1 checks | Passed for each implementation/fix and documentation checkpoint. Full tracked-tree and Git-history checks found no secrets/private identifiers; scanner results are redacted and raw evidence remains ignored. |

The final retention tests cover administrator and scoped-key authority, both directions of retention change, both policy states and missing-authority denials. They assert the exact PATCH body and rendered returned state. New deferred-list tests preserve unrelated files and the requested 404/410 error without restoring an unavailable selection or replacing a genuinely newer selection. These are rendered client regressions, separate from actual server/browser runs.

The controller visually inspected secret-free synthetic portrait screenshots at desktop and 320 pixels. All runtime credentials, media, screenshots, generated fixture records and diagnostics remain ignored. The explicitly owned disposable Phase D PostgreSQL container was removed after final checks.

Phase D is ready for separately authorized Phase E work. Release checklist gates remain unchecked. Physical-phone/reachable public HTTPS, other browser engines/platforms/architectures, upgrade/restore, public-clone CI and release acceptance remain unverified. No private application/runtime/source history was used; nothing was pushed, published or deployed to production.
