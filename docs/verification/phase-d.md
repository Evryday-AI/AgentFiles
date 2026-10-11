# Phase D: agent integration evidence

Verification date: 2026-10-11. D1 is implemented locally; independent review remains the controller's gate. D2 browser/phone work and release acceptance remain pending. These local tests do not establish a public deployment or an installable release.

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
| `node scripts/smoke-compose.mjs --agents` | 14 actual scenarios passed before review fixes; only its unique owned services/networks/volumes and client image were removed. Distributed clients/runtime assets are unchanged by those fixes, so Compose was not repeated; the expanded mock suite was rerun separately. |
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

Complete staged-diff inspection and redacted secret/private-identifier checks passed before the local commit, including the distributed skill. The final Compose run verified public instance fields, literal served skill bytes and absence of fixture secrets; its runtime artifact check excluded environment/private/test/source directories and matched immutable migration bytes. The controller performs the independent task review. D1 does not claim native Linux host installation, Windows Bash, other architectures, public HTTPS, phone/browser acceptance, full-size 1 GiB transfer performance, abrupt-power-loss durability, upgrades/restores, public-clone CI or release publication. The dedicated Phase D PostgreSQL fixture remains available to the controller for further local checks and will be removed by its owner after final verification.
